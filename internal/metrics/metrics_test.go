package metrics

import (
	"math"
	"testing"
)

func TestGradeScale(t *testing.T) {
	cases := []struct {
		ms   float64
		want string
	}{
		{0, "A+"},
		{4.9, "A+"},
		{5, "A"},
		{29, "A"},
		{60, "C"},
		{400, "F"},
		{math.NaN(), "—"},
	}
	for _, c := range cases {
		if g := Grade(c.ms); g != c.want {
			t.Fatalf("Grade(%v)=%s want %s", c.ms, g, c.want)
		}
	}
}

func TestIncreaseNoiseFloor(t *testing.T) {
	idle := []float64{10, 10, 10, 10, 10}
	loaded := []float64{11, 11, 11, 11, 11}
	if got := Increase(idle, loaded); got != 0 {
		t.Fatalf("got %v want 0", got)
	}
}

func TestWorseGrade(t *testing.T) {
	if WorseGrade("A", "C") != "C" {
		t.Fatal("expected C")
	}
	if WorseGrades("A+", "A", "B") != "B" {
		t.Fatal("expected B")
	}
}

func TestJitterAndLoss(t *testing.T) {
	if LossPercent(1, 4) != 25 {
		t.Fatal("loss")
	}
	j := JitterMs([]float64{10, 12, 11, 15})
	// |2|+|1|+|4| / 3 = 7/3
	if math.Abs(j-7.0/3.0) > 0.01 {
		t.Fatalf("jitter=%v", j)
	}
}

func TestRPM(t *testing.T) {
	// 10 successes in 2s => 300 / min
	if RPM(10, 2) != 300 {
		t.Fatalf("rpm=%v", RPM(10, 2))
	}
}

func TestRecovery(t *testing.T) {
	samples := []float64{80, 60, 25, 12, 11}
	got := RecoveryMsUntil(samples, 10, 5, 200) // threshold 15, first hit index 3
	if got != 600 {
		t.Fatalf("recovery=%v want 600", got)
	}
	times := []float64{0, 250, 500, 780, 1000}
	stable := RecoveryMsStable(samples, times, 10, 5, 2) // need two ≤15: indices 3,4 → 1000
	if stable != 1000 {
		t.Fatalf("stable=%v want 1000", stable)
	}
}
