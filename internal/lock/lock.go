package lock

import (
	"sync"
	"time"
)

type UploadStats struct {
	Bytes  int64 `json:"bytes"`
	Active int   `json:"active"`
}
type holder struct {
	expires time.Time
	uploads [2]UploadStats
}

// TestLock allows a limited number of concurrent tests with TTL auto-release.
type TestLock struct {
	mu      sync.Mutex
	max     int
	ttl     time.Duration
	holders map[string]*holder
	now     func() time.Time
}

func New(maxConcurrent int, ttl time.Duration) *TestLock {
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	return &TestLock{
		max:     maxConcurrent,
		ttl:     ttl,
		holders: make(map[string]*holder),
		now:     time.Now,
	}
}

func (l *TestLock) purgeExpiredLocked() {
	now := l.now()
	for id, expires := range l.holders {
		if !now.Before(expires.expires) {
			delete(l.holders, id)
		}
	}
}

// TryAcquire returns true if the session acquired a slot.
func (l *TestLock) TryAcquire(sessionID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.purgeExpiredLocked()

	if h, ok := l.holders[sessionID]; ok {
		h.expires = l.now().Add(l.ttl)
		return true
	}

	if len(l.holders) >= l.max {
		return false
	}
	l.holders[sessionID] = &holder{expires: l.now().Add(l.ttl)}
	return true
}

// Release frees the session slot if held.
func (l *TestLock) Release(sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.holders, sessionID)
}

// Active returns the number of non-expired holders.
func (l *TestLock) Active() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.purgeExpiredLocked()
	return len(l.holders)
}

// Has reports whether sessionID currently holds a non-expired lock.
func (l *TestLock) Has(sessionID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.purgeExpiredLocked()
	_, ok := l.holders[sessionID]
	return ok
}

// Touch refreshes TTL for an existing holder. Returns false if not held.
func (l *TestLock) Touch(sessionID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.purgeExpiredLocked()
	if _, ok := l.holders[sessionID]; !ok {
		return false
	}
	l.holders[sessionID].expires = l.now().Add(l.ttl)
	return true
}

// Upload accounts received payload, including incomplete requests, within a session.
func (l *TestLock) Upload(id string, phase int, bytes int64, activeDelta int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.purgeExpiredLocked()
	h, ok := l.holders[id]
	if !ok || phase < 0 || phase > 1 {
		return false
	}
	h.uploads[phase].Bytes += bytes
	h.uploads[phase].Active += activeDelta
	return true
}

func (l *TestLock) UploadStats(id string, phase int) (UploadStats, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.purgeExpiredLocked()
	h, ok := l.holders[id]
	if !ok || phase < 0 || phase > 1 {
		return UploadStats{}, false
	}
	return h.uploads[phase], true
}
