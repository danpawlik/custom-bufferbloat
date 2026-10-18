package metrics

import (
	"math"
	"testing"
)

func TestCalibrationStatus(t *testing.T) {
	cases := []struct {
		speeds []float64
		want   string
	}{
		{nil, "unconfirmed"}, {[]float64{10}, "unconfirmed"},
		{[]float64{10, 12, 15}, "rising"}, {[]float64{100, 105}, "plateau"},
		{[]float64{100, 80}, "plateau"}, {[]float64{100, 79}, "unstable"},
		{[]float64{100, math.NaN(), 100}, "unconfirmed"}, {[]float64{0, 100}, "unconfirmed"},
		{[]float64{100, math.Inf(1)}, "unconfirmed"},
	}
	for _, tc := range cases {
		if got := CalibrationStatus(tc.speeds); got != tc.want {
			t.Errorf("%v: %s want %s", tc.speeds, got, tc.want)
		}
	}
}

func TestExpectedSpeedWarnings(t *testing.T) {
	for _, tc := range []struct {
		status          string
		speed, expected float64
		count           int
	}{
		{"plateau", 80, 100, 0}, {"plateau", 79.9, 100, 1}, {"plateau", 1, 0, 0},
		{"rising", 50, 100, 2}, {"unconfirmed", 90, 100, 1},
	} {
		if got := SaturationWarnings(tc.status, tc.speed, tc.expected); len(got) != tc.count {
			t.Errorf("%+v: %v", tc, got)
		}
	}
}

func TestSummary(t *testing.T) {
	values := []float64{30, 10, 20, math.NaN()}
	got, ok := Summarize(values)
	if !ok || got.Count != 3 || got.Median != 20 || got.Min != 10 || got.Max != 30 || got.Spread != 20 {
		t.Fatalf("%+v", got)
	}
	if values[0] != 30 {
		t.Fatal("input mutated")
	}
	got, ok = Summarize([]float64{10, 20})
	if !ok || got.Median != 15 {
		t.Fatalf("%+v", got)
	}
	if _, ok = Summarize([]float64{math.NaN(), math.Inf(1)}); ok {
		t.Fatal("missing data included")
	}
}
