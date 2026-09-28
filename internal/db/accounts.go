package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/mattn/go-sqlite3"
)

var ErrEmailTaken = errors.New("email already registered")

type Account struct {
	ID          int64   `json:"id"`
	Email       string  `json:"email"`
	FirstName   string  `json:"first_name"`
	LastName    string  `json:"last_name"`
	DateOfBirth string  `json:"date_of_birth"`
	Nickname    *string `json:"nickname"`
	AboutMe     *string `json:"about_me"`
	DisplayName string  `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
}

type NewAccount struct {
	Email       string
	Password    string
	FirstName   string
	LastName    string
	DateOfBirth string
	Nickname    *string
	AboutMe     *string
}

// CreateRegisteredAccount commits the account and its first session together.
// avatarKey names a private file already made durable by the caller.
func CreateRegisteredAccount(ctx context.Context, database *sql.DB, input NewAccount, avatarKey, ip, userAgent string) (Account, Session, error) {
	hash, err := hashPassword(input.Password)
	if err != nil {
		return Account{}, Session{}, err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return Account{}, Session{}, fmt.Errorf("begin registration: %w", err)
	}
	defer tx.Rollback()
	username := "u" + strings.ReplaceAll(uuid.NewString(), "-", "")[:29]
	var key any
	if avatarKey != "" {
		key = avatarKey
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO users
		(username, email, password_hash, first_name, last_name, date_of_birth, nickname, about_me, avatar_key)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, username, input.Email, hash, input.FirstName,
		input.LastName, input.DateOfBirth, input.Nickname, input.AboutMe, key)
	if err != nil {
		var sqliteErr sqlite3.Error
		if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
			// Email is the only client-provided unique value.
			return Account{}, Session{}, ErrEmailTaken
		}
		return Account{}, Session{}, fmt.Errorf("insert account: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Account{}, Session{}, fmt.Errorf("account id: %w", err)
	}
	token := generateSessionToken()
	sessionResult, err := tx.ExecContext(ctx, `INSERT INTO sessions (user_id, token, ip, user_agent) VALUES (?, ?, ?, ?)`, id, token, ip, userAgent)
	if err != nil {
		return Account{}, Session{}, fmt.Errorf("insert registration session: %w", err)
	}
	sessionID, err := sessionResult.LastInsertId()
	if err != nil {
		return Account{}, Session{}, fmt.Errorf("session id: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Account{}, Session{}, fmt.Errorf("commit registration: %w", err)
	}
	account := Account{ID: id, Email: input.Email, FirstName: input.FirstName,
		LastName: input.LastName, DateOfBirth: input.DateOfBirth,
		Nickname: input.Nickname, AboutMe: input.AboutMe,
		DisplayName: input.FirstName + " " + input.LastName}
	if input.Nickname != nil {
		account.DisplayName = *input.Nickname
	}
	if avatarKey != "" {
		url := fmt.Sprintf("/api/v1/users/%d/avatar", id)
		account.AvatarURL = &url
	}
	return account, Session{ID: sessionID, UserID: id, Token: token, IP: ip, UserAgent: userAgent, IsValid: true}, nil
}

func AvatarKey(ctx context.Context, database *sql.DB, id int64) (string, error) {
	var key sql.NullString
	err := database.QueryRowContext(ctx, `SELECT avatar_key FROM users WHERE id = ?`, id).Scan(&key)
	if err != nil {
		return "", err
	}
	if !key.Valid {
		return "", sql.ErrNoRows
	}
	return key.String, nil
}

func CreateAccount(ctx context.Context, database *sql.DB, input NewAccount) (Account, error) {
	hash, err := hashPassword(input.Password)
	if err != nil {
		return Account{}, err
	}
	// Internal identifier satisfies retained forum joins. It is never a login
	// field or part of the social-network Account response.
	username := "u" + strings.ReplaceAll(uuid.NewString(), "-", "")[:29]
	result, err := database.ExecContext(ctx, `
		INSERT INTO users (username, email, password_hash, first_name, last_name,
			date_of_birth, nickname, about_me)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		username, input.Email, hash, input.FirstName, input.LastName,
		input.DateOfBirth, input.Nickname, input.AboutMe)
	if err != nil {
		var sqliteErr sqlite3.Error
		if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
			var existing int
			if lookupErr := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE email = ?`, input.Email).Scan(&existing); lookupErr == nil && existing > 0 {
				return Account{}, ErrEmailTaken
			}
		}
		return Account{}, fmt.Errorf("insert account: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Account{}, fmt.Errorf("account id: %w", err)
	}
	return GetAccount(ctx, database, id)
}

func GetAccount(ctx context.Context, database *sql.DB, id int64) (Account, error) {
	var account Account
	var nickname, about, avatar sql.NullString
	err := database.QueryRowContext(ctx, `
		SELECT id, email, first_name, last_name, date_of_birth,
			nickname, about_me, avatar_key
		FROM users WHERE id = ?`, id).Scan(
		&account.ID, &account.Email, &account.FirstName, &account.LastName,
		&account.DateOfBirth, &nickname, &about, &avatar)
	if err != nil {
		return Account{}, fmt.Errorf("get account: %w", err)
	}
	if nickname.Valid {
		account.Nickname = &nickname.String
	}
	if about.Valid {
		account.AboutMe = &about.String
	}
	account.DisplayName = account.FirstName + " " + account.LastName
	if account.Nickname != nil {
		account.DisplayName = *account.Nickname
	}
	if avatar.Valid {
		url := fmt.Sprintf("/api/v1/users/%d/avatar", id)
		account.AvatarURL = &url
	}
	return account, nil
}
