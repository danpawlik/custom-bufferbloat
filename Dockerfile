# Build
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/bufferbloat-test ./cmd/server

# Runtime
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/bufferbloat-test /usr/local/bin/bufferbloat-test
EXPOSE 8080
ENV LISTEN=:8080
ENTRYPOINT ["/usr/local/bin/bufferbloat-test"]
