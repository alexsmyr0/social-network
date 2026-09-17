// Internal/db/users.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

const (
	userTimeout       = 10 * time.Second
	minUsernameLength = 3
	maxUsernameLength = 30
	minPasswordLength = 8
	maxPasswordLength = 64
)

type User struct {
	ID           int64  `json:"id"`
	Username     string `json:"username"`
	Email        string `json:"email"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name"`
	Age          int    `json:"age"`
	Gender       string `json:"gender"`
	PasswordHash string `json:"-"`
	IsActive     bool   `json:"is_active"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

type CreateUserRequest struct {
	Username  string `json:"username"`
	Email     string `json:"email"`
	Password  string `json:"password"`
	Age       int    `json:"age"`
	Gender    string `json:"gender"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

type LoginRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

/*------------
  PUBLIC API
------------*/

func CreateUser(
	ctx context.Context,
	db *sql.DB,
	req CreateUserRequest,
) (int64, error) {

	ctx, cancel := context.WithTimeout(ctx, userTimeout)
	defer cancel()

	if err := validateCreateUser(req); err != nil {
		return 0, err
	}

	hash, err := hashPassword(req.Password)
	if err != nil {
		return 0, err
	}

	id, err := insertUser(
		ctx,
		db,
		req.Username,
		req.Email,
		hash,
		req.FirstName,
		req.LastName,
		req.Age,
		req.Gender,
	)
	if err != nil {
		return 0, err
	}

	return id, nil
}

func LoginUser(
	ctx context.Context,
	db *sql.DB,
	req LoginRequest,
) (User, error) {

	ctx, cancel := context.WithTimeout(ctx, userTimeout)
	defer cancel()

	user, err := fetchUserForLogin(ctx, db, req)
	if err != nil {
		return User{}, err
	}

	if err := comparePassword(user.PasswordHash, req.Password); err != nil {
		return User{}, ErrInvalidCredentials
	}

	// A deactivated account must not be able to start a session. The flag was
	// selected by fetchUserForLogin but never acted on, so is_active = 0 was
	// decorative. Reported as invalid credentials so the response does not
	// disclose that the account exists.
	if !user.IsActive {
		return User{}, ErrInvalidCredentials
	}

	return user, nil
}

func GetUser(
	ctx context.Context,
	db *sql.DB,
	id int64,
) (User, error) {

	ctx, cancel := context.WithTimeout(ctx, userTimeout)
	defer cancel()

	var user User
	err := db.QueryRowContext(ctx,
		`SELECT id, username, email, first_name, last_name, age, gender, is_active, created_at, updated_at
		 FROM users
		 WHERE id = ?`,
		id,
	).Scan(
		&user.ID,
		&user.Username,
		&user.Email,
		&user.FirstName,
		&user.LastName,
		&user.Age,
		&user.Gender,
		&user.IsActive,
		&user.CreatedAt,
		&user.UpdatedAt,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return User{}, fmt.Errorf("user not found")
		}
		return User{}, fmt.Errorf("get user: %w", err)
	}

	return user, nil
}

func GetUsersByIDs(ctx context.Context, db *sql.DB, ids []int64) ([]User, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, userTimeout)
	defer cancel()

	// Build query with placeholders
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(
		`SELECT id, username, email, age, gender, first_name, last_name, is_active, created_at, updated_at
		 FROM users WHERE id IN (%s)`,
		strings.Join(placeholders, ","),
	)

	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get users by ids: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Username, &user.Email, &user.Age, &user.Gender, &user.FirstName, &user.LastName, &user.IsActive, &user.CreatedAt, &user.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		users = append(users, user)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}

	return users, nil
}
