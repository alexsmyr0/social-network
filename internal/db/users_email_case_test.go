// internal/db/users_email_case_test.go
//
// Audit Q5/Q6 regression cover. Registration used to store the email exactly as
// typed while login folded it to lower case, so an address with any capital in
// it registered successfully and then failed to authenticate. The same mismatch
// let one address occupy two accounts, because the UNIQUE constraint on
// users.email is case-sensitive.
package db

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

func mustCreateUser(t *testing.T, ctx context.Context, database *sql.DB, username, email string) int64 {
	t.Helper()

	id, err := CreateUser(ctx, database, CreateUserRequest{
		Username:  username,
		Email:     email,
		Password:  "password123",
		Age:       30,
		Gender:    "other",
		FirstName: "First",
		LastName:  "Last",
	})
	if err != nil {
		t.Fatalf("create user %s: %v", username, err)
	}
	return id
}

func TestRegisterStoresEmailLowerCased(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	id := mustCreateUser(t, ctx, database, "mixedcase", "Alice@Example.COM")

	var stored string
	if err := database.QueryRowContext(ctx, `SELECT email FROM users WHERE id = ?`, id).Scan(&stored); err != nil {
		t.Fatalf("read back email: %v", err)
	}

	if stored != "alice@example.com" {
		t.Fatalf("email stored as %q, want %q", stored, "alice@example.com")
	}
}

func TestLoginByEmailAcceptsAnyCasing(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	want := mustCreateUser(t, ctx, database, "casingtest", "Bob@Example.com")

	// Every casing of the same address must reach the same account — above all
	// the exact string the user typed at registration, which is what an auditor
	// will retype at the login screen.
	for _, attempt := range []string{
		"Bob@Example.com",
		"bob@example.com",
		"BOB@EXAMPLE.COM",
		"bOb@ExAmPlE.cOm",
	} {
		user, err := LoginUser(ctx, database, LoginRequest{Email: attempt, Password: "password123"})
		if err != nil {
			t.Fatalf("login with email %q failed: %v", attempt, err)
		}
		if user.ID != want {
			t.Fatalf("login with email %q resolved user %d, want %d", attempt, user.ID, want)
		}
	}
}

func TestRegisterRejectsSameEmailInDifferentCase(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	mustCreateUser(t, ctx, database, "firstclaim", "Carol@Example.com")

	_, err := CreateUser(ctx, database, CreateUserRequest{
		Username:  "secondclaim",
		Email:     "carol@example.com",
		Password:  "password123",
		Age:       30,
		Gender:    "other",
		FirstName: "First",
		LastName:  "Last",
	})
	if err == nil {
		t.Fatal("a second account was created for the same address in a different case")
	}
	if !strings.Contains(err.Error(), "email already exists") {
		t.Fatalf("unexpected error for duplicate email: %v", err)
	}
}

// A deactivated account must not be able to start a session. is_active was
// selected during login and then ignored, so the flag did nothing.
func TestLoginRejectsDeactivatedAccount(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	id := mustCreateUser(t, ctx, database, "deactivated", "gone@example.com")

	if _, err := LoginUser(ctx, database, LoginRequest{
		Username: "deactivated",
		Password: "password123",
	}); err != nil {
		t.Fatalf("active account should log in: %v", err)
	}

	if _, err := database.ExecContext(ctx, `UPDATE users SET is_active = 0 WHERE id = ?`, id); err != nil {
		t.Fatalf("deactivate user: %v", err)
	}

	if _, err := LoginUser(ctx, database, LoginRequest{
		Username: "deactivated",
		Password: "password123",
	}); err != ErrInvalidCredentials {
		t.Fatalf("deactivated login returned %v, want ErrInvalidCredentials", err)
	}
}
