FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/backend ./cmd/backend
COPY internal ./internal
RUN CGO_ENABLED=1 go build -trimpath -o /server ./cmd/backend

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 app && useradd -u 10001 -g app -M app \
    && mkdir -p /data /app && chown app:app /data
WORKDIR /app
COPY --from=build /server /app/server
ENV DB_PATH=/data/social.db MEDIA_ROOT=/data/media FRONTEND_URL=http://localhost:3000
EXPOSE 8080
VOLUME /data
USER app
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/api/v1/health >/dev/null || exit 1
CMD ["/app/server"]
