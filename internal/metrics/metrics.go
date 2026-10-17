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

// WorseGrades returns the worst grade among many.
func WorseGrades(grades ...string) string {
	if len(grades) == 0 {
		return "—"
	}
	worst := grades[0]
	for _, g := range grades[1:] {
		worst = WorseGrade(worst, g)
	}
	return worst
}

// Mbps converts bytes transferred over durationMs to megabits/sec.
func Mbps(bytes int64, durationMs float64) float64 {
	if durationMs <= 0 {
		return math.NaN()
	}
	return float64(bytes) * 8 / (durationMs / 1000) / 1e6
}

// LossPercent is failedAttempts / totalAttempts * 100.
func LossPercent(failed, total int) float64 {
	if total <= 0 {
		return math.NaN()
	}
	return float64(failed) / float64(total) * 100
}

// JitterMs is mean |ΔRTT| between consecutive successful probes (variability metric,
// not VoIP RFC 3550 interarrival jitter).
func JitterMs(samples []float64) float64 {
	if len(samples) < 2 {
		return math.NaN()
	}
	var sum float64
	for i := 1; i < len(samples); i++ {
		d := samples[i] - samples[i-1]
		if d < 0 {
			d = -d
		}
		sum += d
	}
	return sum / float64(len(samples)-1)
}

// RPM approximates successful probes per minute over durationSec.
func RPM(successes int, durationSec float64) float64 {
	if durationSec <= 0 {
		return math.NaN()
	}
	return float64(successes) / durationSec * 60
}

// RecoveryMsUntil is kept for simple evenly-spaced estimates (tests / CLI fallback).
func RecoveryMsUntil(samples []float64, baselineP50, slackMs, intervalMs float64) float64 {
	times := make([]float64, len(samples))
	for i := range samples {
		times[i] = float64(i) * intervalMs
	}
	return RecoveryMsStable(samples, times, baselineP50, slackMs, 1)
}

// RecoveryMsStable returns elapsed ms (from sampleTimesMs) when `need` consecutive
// samples are ≤ baselineP50+slackMs. sampleTimesMs[i] is time of samples[i] from
// phase start. Returns NaN if never stably recovered.
func RecoveryMsStable(samples, sampleTimesMs []float64, baselineP50, slackMs float64, need int) float64 {
	if len(samples) == 0 || math.IsNaN(baselineP50) || len(samples) != len(sampleTimesMs) {
		return math.NaN()
	}
	if need < 1 {
		need = 1
	}
	threshold := baselineP50 + slackMs
	streak := 0
	for i, s := range samples {
		if s <= threshold {
			streak++
			if streak >= need {
				return sampleTimesMs[i]
			}
		} else {
			streak = 0
		}
	}
	return math.NaN()
}
