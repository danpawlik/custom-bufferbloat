package metrics

import (
	"math"
	"sort"
)

// Percentile returns the p-th percentile (0-100) of samples.
func Percentile(samples []float64, p float64) float64 {
	if len(samples) == 0 {
		return math.NaN()
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	idx := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// Increase computes loaded p90 - idle p5; values under 2ms count as 0 (noise floor).
func Increase(idle, loaded []float64) float64 {
	delta := Percentile(loaded, 90) - Percentile(idle, 5)
	if math.IsNaN(delta) {
		return math.NaN()
	}
	if delta < 2 {
		return 0
	}
	return delta
}

// Grade returns A+..F for a latency increase in milliseconds.
func Grade(increaseMs float64) string {
	if math.IsNaN(increaseMs) || increaseMs < 0 {
		return "—"
	}
	switch {
	case increaseMs < 5:
		return "A+"
	case increaseMs < 30:
		return "A"
	case increaseMs < 60:
		return "B"
	case increaseMs < 200:
		return "C"
	case increaseMs < 400:
		return "D"
	default:
		return "F"
	}
}

var gradeRank = map[string]int{"A+": 0, "A": 1, "B": 2, "C": 3, "D": 4, "F": 5, "—": 6}

// WorseGrade returns the worse of two letter grades.
func WorseGrade(a, b string) string {
	ra, oka := gradeRank[a]
	rb, okb := gradeRank[b]
	if !oka {
		ra = 6
	}
	if !okb {
		rb = 6
	}
	if ra >= rb {
		return a
	}
	return b
}

// Mbps converts bytes transferred over durationMs to megabits/sec.
func Mbps(bytes int64, durationMs float64) float64 {
	if durationMs <= 0 {
		return math.NaN()
	}
	return float64(bytes) * 8 / (durationMs / 1000) / 1e6
}
