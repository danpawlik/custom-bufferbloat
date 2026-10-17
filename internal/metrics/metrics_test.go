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
	if WorseGrade("A+", "A") != "A" {
		t.Fatal("expected A")
	}
}
