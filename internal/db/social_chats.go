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
func socialCreateMessage(ctx context.Context, database *sql.DB, viewer int64, req CreateMessageRequest) (PrivateMessage, error) {
	if viewer != req.SenderID {
		return PrivateMessage{}, sql.ErrNoRows
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return PrivateMessage{}, err
	}
	defer tx.Rollback()
	var active int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_active=1 AND id IN (?,?)`, viewer, req.RecipientID).Scan(&active); err != nil {
		return PrivateMessage{}, err
	}
	if active != 2 {
		return PrivateMessage{}, sql.ErrNoRows
	}
	var image *string
	if req.ImagePath != "" {
		image = &req.ImagePath
	}
	if err := claimMediaTx(ctx, tx, viewer, "message", 0, image, req.RecipientID); err != nil {
		return PrivateMessage{}, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO private_messages(sender_id,recipient_id,body,image_path) VALUES(?,?,?,?)`, viewer, req.RecipientID, req.Body, image)
	if err != nil {
		return PrivateMessage{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return PrivateMessage{}, err
	}
	if err := finishMediaClaimTx(ctx, tx, image); err != nil {
		return PrivateMessage{}, err
	}
	msg := PrivateMessage{ID: id, SenderID: viewer, RecipientID: req.RecipientID, Body: req.Body, ImagePath: image}
	if err := tx.QueryRowContext(ctx, `SELECT created_at FROM private_messages WHERE id=?`, id).Scan(&msg.CreatedAt); err != nil {
		return msg, err
	}
	return msg, tx.Commit()
}
func socialMessageHistory(ctx context.Context, database *sql.DB, viewer, other, before int64) ([]PrivateMessage, bool, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	var active bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`, viewer).Scan(&active); err != nil {
		return nil, false, err
	}
	if !active {
		return nil, false, sql.ErrNoRows
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,sender_id,recipient_id,body,image_path,created_at FROM private_messages WHERE ((sender_id=?1 AND recipient_id=?2) OR(sender_id=?2 AND recipient_id=?1)) AND (?3=0 OR id<?3) ORDER BY id DESC LIMIT 11`, viewer, other, before)
	if err != nil {
		return nil, false, err
	}
	msgs := []PrivateMessage{}
	images := []sql.NullString{}
	for rows.Next() {
		var m PrivateMessage
		var image sql.NullString
		if err := rows.Scan(&m.ID, &m.SenderID, &m.RecipientID, &m.Body, &image, &m.CreatedAt); err != nil {
			rows.Close()
			return nil, false, err
		}
		msgs = append(msgs, m)
		images = append(images, image)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, false, err
	}
	more := len(msgs) > 10
	if more {
		msgs = msgs[:10]
	}
	for i := range msgs {
		msgs[i].ImagePath, err = resourceMediaURLTx(ctx, tx, "message", msgs[i].ID, images[i])
		if err != nil {
			return nil, false, err
		}
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, more, tx.Commit()
}
