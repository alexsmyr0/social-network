#  Dockerfile

# =========================
# Build stage
# =========================
FROM golang:1.24 AS builder

WORKDIR /app

ENV CGO_ENABLED=1 \
    GOOS=linux \
    GOARCH=amd64

RUN apt-get update && apt-get install -y gcc libc6-dev

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -o server ./cmd/backend

# =========================
# Runtime stage
# =========================
FROM debian:12-slim

# Create non-root user
RUN useradd -m appuser

WORKDIR /app

# Create writable data dir for SQLite
RUN mkdir -p /data && chown -R appuser:appuser /data

ENV PORT=8080 \
    DB_PATH=/data/forum.db \
    TZ=Europe/Athens

COPY --from=builder /app/server /app/server

EXPOSE 8080

USER appuser

VOLUME ["/data"]

CMD ["/app/server"]
