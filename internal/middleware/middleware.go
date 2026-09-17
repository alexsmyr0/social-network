// internal/middleware/middleware.go

package middleware

import (
	"bufio"
	"fmt"
	"log"
	"net"
	"net/http"
	"runtime/debug"
	"time"
)

/*------------------------------------------------------------
	  LOGGER MIDDLEWARE
	  Logs method, path and request duration.
-------------------------------------------------------------*/

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := rw.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("response does not implement http.Hijacker")
}

func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{w, http.StatusOK}

		next.ServeHTTP(rw, r)

		log.Printf("%-6s %-40s %d %s", r.Method, r.URL.Path, rw.status, time.Since(start))
	})
}

/*------------------------------------------------------------
	  RECOVERER MIDDLEWARE
	Prevents server crash on panic and returns a safe JSON error.
-------------------------------------------------------------*/

func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {

				// Log panic + stack trace (backend only)
				log.Printf("PANIC: %v\n%s", rec, debug.Stack())

				// Minimal, framework-agnostic response
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(
					`{"error":{"code":"SERVER_ERROR","message":"internal server error"}}`,
				))
			}
		}()

		next.ServeHTTP(w, r)
	})
}

/*------------------------------------------------------------
	  EnableCORS MIDDLEWARE
	  Enables frontend ↔ backend communication on different ports.
--------------------------------------------------------------*/

func EnableCORS(origin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func AllowMethods(h http.Handler, methods ...string) http.Handler {
	allowed := make(map[string]struct{}, len(methods))
	for _, m := range methods {
		allowed[m] = struct{}{}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := allowed[r.Method]; !ok {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.ServeHTTP(w, r)
	})
}
