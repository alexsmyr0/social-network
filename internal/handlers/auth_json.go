package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"unicode/utf8"
)

// decodeStrictAuthObject rejects duplicate keys before Go's JSON decoder can
// silently keep the last value. It also rejects invalid UTF-8 and trailing data.
func decodeStrictAuthObject(w http.ResponseWriter, r *http.Request, target any, allowedKeys ...string) *APIError {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return NewError("PAYLOAD_TOO_LARGE", "request is too large", http.StatusRequestEntityTooLarge)
		}
		return NewError("BAD_REQUEST", "invalid request body", http.StatusBadRequest)
	}
	if !utf8.Valid(raw) {
		return NewError("BAD_REQUEST", "invalid UTF-8", http.StatusBadRequest)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return NewError("BAD_REQUEST", "expected a JSON object", http.StatusBadRequest)
	}
	seen := make(map[string]bool)
	allowed := make(map[string]bool, len(allowedKeys))
	for _, key := range allowedKeys {
		allowed[key] = true
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return NewError("BAD_REQUEST", "invalid JSON", http.StatusBadRequest)
		}
		name, ok := key.(string)
		if !ok || !allowed[name] {
			return NewError("BAD_REQUEST", "unknown JSON key", http.StatusBadRequest)
		}
		if seen[name] {
			return NewError("BAD_REQUEST", "repeated JSON key", http.StatusBadRequest)
		}
		seen[name] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return NewError("BAD_REQUEST", "invalid JSON", http.StatusBadRequest)
		}
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return NewError("BAD_REQUEST", "invalid JSON", http.StatusBadRequest)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return NewError("BAD_REQUEST", "trailing JSON data", http.StatusBadRequest)
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return NewError("BAD_REQUEST", "invalid JSON fields", http.StatusBadRequest)
	}
	return nil
}
