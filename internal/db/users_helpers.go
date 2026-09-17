// internal/db/users_helpers.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func validateCreateUser(req CreateUserRequest) error {
	// Username validation
	switch {
	case len(req.Username) < minUsernameLength:
		return fmt.Errorf("username must be at least %d characters long", minUsernameLength)
	case len(req.Username) > maxUsernameLength:
		return fmt.Errorf("username can't be longer than %d characters", maxUsernameLength)
	case strings.Contains(req.Username, "@"):
		return fmt.Errorf("username can't contain '@'")
	case strings.Contains(req.Username, " "):
		return fmt.Errorf("username can't contain spaces")
	case !hasOnlyAllowedUsernameChars(req.Username):
		return fmt.Errorf("username can only contain letters, numbers, '-', '.', '_'")
	case hasConsecutiveUsernameSeparators(req.Username):
		return fmt.Errorf("username can't contain consecutive separators")
	case !validateStartAndEndUsernameChars(req.Username):
		return fmt.Errorf("username must start and end with a letter or number")
	}
	// Email validation
	switch {
	case !strings.Contains(req.Email, "@"):
		return fmt.Errorf("invalid email address")
	case strings.Contains(req.Email, " "):
		return fmt.Errorf("email can't contain spaces")
	}
	// Password validation
	switch {
	case len(req.Password) < minPasswordLength:
		return fmt.Errorf("password must be at least %d characters long", minPasswordLength)
	case len(req.Password) > maxPasswordLength:
		return fmt.Errorf("password can't be longer than %d characters", maxPasswordLength)
	case strings.Contains(req.Password, " "):
		return fmt.Errorf("password can't contain spaces")
	}
	// Profile field validation
	switch {
	case req.Age <= 0:
		return fmt.Errorf("age must be a positive integer")
	case strings.TrimSpace(req.Gender) == "":
		return fmt.Errorf("gender is required")
	case strings.TrimSpace(req.FirstName) == "":
		return fmt.Errorf("first name is required")
	case strings.TrimSpace(req.LastName) == "":
		return fmt.Errorf("last name is required")
	}

	return nil
}

func hasOnlyAllowedUsernameChars(username string) bool {
	for _, r := range username {
		switch {
		case r >= 'a' && r <= 'z':
			continue
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
			continue
		case r == '-', r == '.', r == '_':
			continue
		default:
			return false
		}
	}

	return true
}

func validateStartAndEndUsernameChars(username string) bool {
	if len(username) == 0 {
		return false
	}

	start := username[0]
	end := username[len(username)-1]

	isAlnum := func(c byte) bool {
		return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
	}

	return isAlnum(start) && isAlnum(end)
}

func hasConsecutiveUsernameSeparators(username string) bool {
	prevWasSeparator := false

	for _, r := range username {
		isSeparator := r == '-' || r == '.' || r == '_'
		if prevWasSeparator && isSeparator {
			return true
		}
		prevWasSeparator = isSeparator
	}

	return false
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword(
		[]byte(password),
		bcrypt.DefaultCost,
	)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

func comparePassword(hash, password string) error {
	return bcrypt.CompareHashAndPassword(
		[]byte(hash),
		[]byte(password),
	)
}

func insertUser(
	ctx context.Context,
	db *sql.DB,
	username,
	email,
	passwordHash,
	firstName,
	lastName string,
	age int,
	gender string,
) (int64, error) {
	// Both identifiers are stored lower-cased because both are looked up
	// lower-cased at login (fetchUserForLogin). Storing the email verbatim while
	// querying it folded meant an address registered as "Alice@Example.com"
	// could never authenticate, and let the same address register twice — the
	// UNIQUE constraint on users.email is case-sensitive.
	formattedUsername := strings.ToLower(username)
	formattedEmail := strings.ToLower(email)
	result, err := db.ExecContext(ctx,
		`INSERT INTO users (username, email, password_hash, first_name, last_name, age, gender)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		formattedUsername,
		formattedEmail,
		passwordHash,
		firstName,
		lastName,
		age,
		gender,
	)
	if err != nil {
		if isUniqueConstraint(err) {
			msg := err.Error()
			switch {
			case strings.Contains(msg, "username"):
				return 0, fmt.Errorf("username already exists")
			case strings.Contains(msg, "email"):
				return 0, fmt.Errorf("email already exists")
			}
		}
		return 0, fmt.Errorf("insert user: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("last insert id: %w", err)
	}

	return id, nil
}

func fetchUserForLogin(
	ctx context.Context,
	db *sql.DB,
	req LoginRequest,
) (User, error) {

	var row *sql.Row

	if strings.TrimSpace(req.Username) != "" {
		row = db.QueryRowContext(ctx,
			`SELECT id, username, email, first_name, last_name, age, gender, password_hash, is_active
			 FROM users
			 WHERE username = ?`,
			strings.ToLower(req.Username),
		)
	} else {
		row = db.QueryRowContext(ctx,
			`SELECT id, username, email, first_name, last_name, age, gender, password_hash, is_active
			 FROM users
			 WHERE email = ?`,
			strings.ToLower(req.Email),
		)
	}

	var user User
	if err := row.Scan(
		&user.ID,
		&user.Username,
		&user.Email,
		&user.FirstName,
		&user.LastName,
		&user.Age,
		&user.Gender,
		&user.PasswordHash,
		&user.IsActive,
	); err != nil {

		if err == sql.ErrNoRows {
			return User{}, ErrInvalidCredentials
		}
		return User{}, fmt.Errorf("fetch user: %w", err)
	}

	return user, nil
}
