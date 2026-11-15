.PHONY: test vet bench build clean

test:
	go test -race ./...
	node --test web/*.test.js

vet:
	go vet ./...

bench:
	go test ./internal/handlers -run '^$$' -bench BenchmarkTransfer -benchmem -benchtime=1s -count=1

build:
	go build -trimpath -buildvcs=false -ldflags="-s -w" -o bufferbloat-test ./cmd/server
	go build -trimpath -buildvcs=false -ldflags="-s -w" -o bufferbloat-test-cli ./cmd/cli

clean:
	rm -f bufferbloat-test bufferbloat-test-cli
