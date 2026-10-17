package lock

import (
	"testing"
	"time"
)

func TestTryAcquireAndRelease(t *testing.T) {
	l := New(1, time.Minute)
	if !l.TryAcquire("a") {
		t.Fatal("expected acquire")
	}
	if l.TryAcquire("b") {
		t.Fatal("expected 409-style reject for second session")
	}
	l.Release("a")
	if !l.TryAcquire("b") {
		t.Fatal("expected acquire after release")
	}
}

func TestSameSessionRefresh(t *testing.T) {
	l := New(1, time.Minute)
	if !l.TryAcquire("a") {
		t.Fatal("expected acquire")
	}
	if !l.TryAcquire("a") {
		t.Fatal("same session should refresh")
	}
	if l.Active() != 1 {
		t.Fatalf("active=%d want 1", l.Active())
	}
}

func TestTTLExpiry(t *testing.T) {
	l := New(1, 50*time.Millisecond)
	base := time.Now()
	l.now = func() time.Time { return base }

	if !l.TryAcquire("a") {
		t.Fatal("expected acquire")
	}
	l.now = func() time.Time { return base.Add(100 * time.Millisecond) }
	if !l.TryAcquire("b") {
		t.Fatal("expected acquire after TTL")
	}
}
