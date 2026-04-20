.PHONY: dev build clean test

dev:
	go run ./cmd/server

build:
	go build -o bin/botland-server ./cmd/server

clean:
	rm -rf bin/

test:
	go test ./...

lint:
	go vet ./...

deps:
	go mod tidy
