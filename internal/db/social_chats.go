package db

import (
	"context"
	"database/sql"
)

// DisplayNames returns only approved identity fields for active accounts.
func DisplayNames(ctx context.Context, database *sql.DB, ids []int64) (map[int64]string, error) {
	result := map[int64]string{}
	if len(ids) == 0 {
		return result, nil
	}
	args := []any{}
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := database.QueryContext(ctx, `SELECT id,first_name,last_name,nickname FROM users WHERE is_active=1 AND id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var first, last string
		var nick sql.NullString
		if err := rows.Scan(&id, &first, &last, &nick); err != nil {
			return nil, err
		}
		var n *string
		if nick.Valid {
			n = &nick.String
		}
		result[id] = displayName(first, last, n)
	}
	return result, rows.Err()
}
