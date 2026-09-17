// Internal/db/errors.go
package db

import (
	"errors"
	"fmt"
	"strings"
)

/*-----------------------------------
  DOMAIN / DATABASE ERROR SENTINELS
-----------------------------------*/
// These errors are used across the db layer and can be matched
// using errors.Is(...) from callers (handlers, services, etc).

var (
	ErrNotFound           = errors.New("record not found")
	ErrDuplicate          = errors.New("duplicate entry")
	ErrForeignKey         = errors.New("foreign key constraint failed")
	ErrInvalidInput       = errors.New("invalid input")
	ErrSchemaMissing      = errors.New("database schema not applied")
	ErrConnection         = errors.New("database connection error")
	ErrInvalidCredentials = errors.New("invalid username/email or password")
)

/*----------------
  ERROR WRAPPING
----------------*/

// WrapError adds context while preserving the original error.
// Logging is intentionally NOT done here to avoid double-logging.
// The caller (handler / main) decides how to log or expose errors.
func WrapError(context string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", context, err)
}

/*------------------------------
  SQLITE ERROR CLASSIFICATION
------------------------------*/

// Converts SQLite-specific error messages into domain errors.
// This keeps vendor-specific logic isolated inside the db layer.
func MapSQLError(err error) error {
	if err == nil {
		return nil
	}

	msg := err.Error()

	switch {
	case strings.Contains(msg, "UNIQUE constraint failed"):
		return ErrDuplicate
	case strings.Contains(msg, "FOREIGN KEY constraint failed"):
		return ErrForeignKey
	case strings.Contains(msg, "no such table"):
		return ErrSchemaMissing
	default:
		return err
	}
}
