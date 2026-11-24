.PHONY: test vet bench build clean

test:
	go test -race ./...
	node --test web/*.test.js

vet:
	go vet ./...

bench:
	go test ./internal/handlers -run '^$$' -bench BenchmarkTransfer -benchmem -benchtime=1s -count=1

build:
	mkdir -p dist
	go build -trimpath -buildvcs=false -ldflags="-s -w" -o dist/bufferbloat-test ./cmd/server
	go build -trimpath -buildvcs=false -ldflags="-s -w" -o dist/bufferbloat-test-cli ./cmd/cli

clean:
	rm -f dist/bufferbloat-test dist/bufferbloat-test-cli
