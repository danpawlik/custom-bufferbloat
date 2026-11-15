package udpecho

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestEcho(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Run(ctx, "127.0.0.1:0")
	// bind ephemeral port ourselves to discover it, then run server on it
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := pc.LocalAddr().String()
	pc.Close()
	go Run(ctx, addr)
	time.Sleep(20 * time.Millisecond)
	conn, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(time.Second))
	msg := []byte("hello-udp")
	if _, err := conn.Write(msg); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != string(msg) {
		t.Fatalf("echo %q want %q", buf[:n], msg)
	}
}
