package tui

import "testing"

func TestFormatNanoUSD(t *testing.T) {
	value := int64(123456789)
	if got := formatNanoUSD(&value); got != "$0.1235" {
		t.Fatalf("formatNanoUSD() = %q", got)
	}
	if got := formatNanoUSD(nil); got != "n/a" {
		t.Fatalf("formatNanoUSD(nil) = %q", got)
	}
}

func TestFormatCount(t *testing.T) {
	if got := formatCount(12345678); got != "12,345,678" {
		t.Fatalf("formatCount() = %q", got)
	}
}

func TestShortList(t *testing.T) {
	got := shortList([]string{"run-a", "run-b", "run-c"}, 2)
	want := []string{"run-a", "run-b", "+1 more"}
	if len(got) != len(want) {
		t.Fatalf("shortList length = %d", len(got))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("shortList[%d] = %q", index, got[index])
		}
	}
}
