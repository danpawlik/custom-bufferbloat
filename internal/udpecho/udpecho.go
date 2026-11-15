package udpecho

import (
	"context"
	"net"
)

// Run starts a stateless UDP echo on addr until ctx is cancelled.
// Each datagram is echoed verbatim to its sender. Addr "" means disabled.
func Run(ctx context.Context, addr string) error {
	if addr == "" {
		<-ctx.Done()
		return nil
	}
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	defer pc.Close()
	go func() {
		<-ctx.Done()
		pc.Close()
	}()
	buf := make([]byte, 2048)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				continue
			}
		}
		_, _ = pc.WriteTo(buf[:n], from)
	}
}
