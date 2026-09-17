// internal/db/migrate_email_case_test.go
//
// Cover for the legacy half of the email-casing fix: insertUser folds new
// addresses, and Migrate has to bring rows written by an older revision into
// line so those accounts can log in by email again.
package db

import (
	"context"
	"database/sql"
	"testing"
)

// insertRawUser writes a row straight through the driver, bypassing CreateUser,
// so a test can reproduce the pre-fix on-disk state.
func insertRawUser(t *testing.T, ctx context.Context, database *sql.DB, username, email string) int64 {
	t.Helper()

	res, err := database.ExecContext(ctx,
		`INSERT INTO users (username, email, password_hash, age, gender, first_name, last_name)
		 VALUES (?, ?, 'x', 30, 'other', 'First', 'Last')`,
		username, email,
	)
	if err != nil {
		t.Fatalf("insert raw user %s: %v", username, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	return id
}

func userEmail(t *testing.T, ctx context.Context, database *sql.DB, id int64) string {
	t.Helper()

	var email string
	if err := database.QueryRowContext(ctx, `SELECT email FROM users WHERE id = ?`, id).Scan(&email); err != nil {
		t.Fatalf("read email for %d: %v", id, err)
	}
	return email
}

func TestMigrateFoldsLegacyMixedCaseEmails(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	id := insertRawUser(t, ctx, database, "legacy", "Legacy@Example.com")

	if err := Migrate(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	if got := userEmail(t, ctx, database, id); got != "legacy@example.com" {
		t.Fatalf("legacy email is %q after migrate, want %q", got, "legacy@example.com")
	}

	// The whole point of folding the row: the account can authenticate by email.
	if _, err := database.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ?`, mustHash(t, "password123"), id,
	); err != nil {
		t.Fatalf("set password: %v", err)
	}

	user, err := LoginUser(ctx, database, LoginRequest{Email: "Legacy@Example.com", Password: "password123"})
	if err != nil {
		t.Fatalf("legacy account still cannot log in by email: %v", err)
	}
	if user.ID != id {
		t.Fatalf("login resolved user %d, want %d", user.ID, id)
	}
}

func TestMigrateAddsCaseInsensitiveEmailGuard(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	insertRawUser(t, ctx, database, "guarded", "guarded@example.com")

	if err := Migrate(ctx, database); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// With the guard in place even a raw insert cannot duplicate an address by
	// changing its case — the application-level fold is no longer the only thing
	// standing between the database and two accounts for one person.
	_, err := database.ExecContext(ctx,
		`INSERT INTO users (username, email, password_hash, age, gender, first_name, last_name)
		 VALUES ('sneaky', 'Guarded@Example.com', 'x', 30, 'other', 'First', 'Last')`,
	)
	if err == nil {
		t.Fatal("duplicate address in a different case was accepted")
	}
}

// A database that already holds two rows for one address cannot take the unique
// index. Migrate must report that and carry on rather than making the app
// unbootable — the rows it CAN fold are still folded.
func TestMigrateToleratesPreExistingDuplicateEmails(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	clashing := insertRawUser(t, ctx, database, "dupeone", "Dupe@Example.com")
	insertRawUser(t, ctx, database, "dupetwo", "dupe@example.com")
	foldable := insertRawUser(t, ctx, database, "loner", "Loner@Example.com")

	if err := Migrate(ctx, database); err != nil {
		t.Fatalf("migrate must not fail on duplicate emails: %v", err)
	}

	// The clashing row keeps its casing: folding it would violate the UNIQUE
	// constraint and abort the boot.
	if got := userEmail(t, ctx, database, clashing); got != "Dupe@Example.com" {
		t.Fatalf("clashing email is %q, want it left untouched", got)
	}
	// Everything unambiguous is still fixed.
	if got := userEmail(t, ctx, database, foldable); got != "loner@example.com" {
		t.Fatalf("unambiguous email is %q, want %q", got, "loner@example.com")
	}
}

func mustHash(t *testing.T, password string) string {
	t.Helper()

	hash, err := hashPassword(password)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	return hash
}
