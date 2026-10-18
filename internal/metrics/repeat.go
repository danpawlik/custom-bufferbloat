package metrics

import (
	"math"
	"sort"
)

// CalibrationStatus describes evidence from increasing load, not proof of link saturation.
func CalibrationStatus(speeds []float64) string {
	if len(speeds) < 2 {
		return "unconfirmed"
	}
	for _, speed := range speeds {
		if speed <= 0 || math.IsNaN(speed) || math.IsInf(speed, 0) {
			return "unconfirmed"
		}
	}
	previous, last := speeds[len(speeds)-2], speeds[len(speeds)-1]
	if last > previous*1.05 {
		return "rising"
	}
	if last < previous*0.8 {
		return "unstable"
	}
	return "plateau"
}

func SaturationWarnings(status string, measured, expected float64) []string {
	warnings := []string{}
	switch status {
	case "plateau":
	case "rising":
		warnings = append(warnings, "Speed was still increasing during calibration.")
	case "unstable":
		warnings = append(warnings, "Speed varied during calibration.")
	default:
		warnings = append(warnings, "Calibration did not reach a steady speed.")
	}
	if expected > 0 && measured < expected*0.8 {
		warnings = append(warnings, "Measured speed was below 80% of your expected speed.")
	}
	return warnings
}

type Spread struct {
	Count  int     `json:"count"`
	Median float64 `json:"median"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Spread float64 `json:"spread"`
}

// Summarize excludes unavailable measurements; callers decide which runs are valid.
func Summarize(values []float64) (Spread, bool) {
	clean := make([]float64, 0, len(values))
	for _, value := range values {
		if !math.IsNaN(value) && !math.IsInf(value, 0) {
			clean = append(clean, value)
		}
	}
	if len(clean) == 0 {
		return Spread{}, false
	}
	sort.Float64s(clean)
	mid := len(clean) / 2
	median := clean[mid]
	if len(clean)%2 == 0 {
		median = clean[mid-1]/2 + clean[mid]/2
	}
	return Spread{len(clean), median, clean[0], clean[len(clean)-1], clean[len(clean)-1] - clean[0]}, true
}
