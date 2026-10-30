package db

import (
	"context"
	"database/sql"
	"errors"
)

// ErrMessageConflict reports a retry nonce reused with different content.
var ErrMessageConflict = errors.New("message retry differs from original")

// DirectMessage is the approved DM DTO. Legacy rows keep client_id null.
type DirectMessage struct {
	ID             int64   `json:"id"`
	SenderID       int64   `json:"sender_id"`
	RecipientID    int64   `json:"recipient_id"`
	SenderUsername string  `json:"sender_username"`
	Body           string  `json:"body"`
	CreatedAt      string  `json:"created_at"`
	ClientID       *string `json:"client_id"`
	ImageURL       *string `json:"image_url,omitempty"`
}

type DirectSendRequest struct {
	SenderID    int64
	RecipientID int64
	ClientID    string
	// Body is already canonical (LF line endings, trimmed). ImageURL is empty
	// for text-only messages.
	Body     string
	ImageURL string
}

type DirectSendResult struct {
	Message   DirectMessage
	Duplicate bool
}

type DirectHistoryPage struct {
	Messages     []DirectMessage
	HasMore      bool
	NextBeforeID *int64
}

type DirectRosterEntry struct {
	UserID             int64   `json:"user_id"`
	Username           string  `json:"username"`
	LastMessageAt      *string `json:"last_message_at"`
	LastMessagePreview *string `json:"last_message_preview"`
	LastSenderID       *int64  `json:"last_sender_id"`
	CanSend            bool    `json:"can_send"`
	UnreadCount        int     `json:"unread_count"`
	ReadThroughID      int64   `json:"read_through_id"`
	IsOnline           *bool   `json:"is_online,omitempty"`
	// PresenceVisible is the viewer's profile permission for this person, read in
	// the roster snapshot; the handler sets IsOnline only when it holds.
	PresenceVisible bool `json:"-"`
}

type DirectRosterPage struct {
	Items []DirectRosterEntry
	Total int
}

type DirectReadResult struct {
	ThroughID   int64
	UnreadCount int
	// Changed is true only when the persisted cursor advanced.
	Changed bool
}

const (
	// dmFollowEither is true when either user has an accepted follow of the other.
	// Pending requests never qualify. ?1 and ?2 are the two users.
	dmFollowEither = `EXISTS(SELECT 1 FROM follows f WHERE f.state='accepted' AND ((f.follower_id=?1 AND f.followed_id=?2) OR (f.follower_id=?2 AND f.followed_id=?1)))`
	dmBothActive   = `(SELECT COUNT(*) FROM users WHERE is_active=1 AND id IN(?1,?2))=2`
	dmHasHistory   = `EXISTS(SELECT 1 FROM private_messages WHERE (sender_id=?1 AND recipient_id=?2) OR (sender_id=?2 AND recipient_id=?1))`
	// dmCanSendSQL is the single send predicate: distinct active participants and an
	// accepted follow in either direction. Sends, uploads, retries and live delivery
	// all derive from it.
	dmCanSendSQL = `(?1<>?2 AND ` + dmBothActive + ` AND ` + dmFollowEither + `)`
)

func dmCanSend(ctx context.Context, q ProfileReader, a, b int64) (bool, error) {
	var ok bool
	err := q.QueryRowContext(ctx, `SELECT `+dmCanSendSQL, a, b).Scan(&ok)
	return ok, err
}

// DirectAccessible reports whether viewer may see the conversation with other.
// Retained history keeps both participants in after the relationship ends.
func DirectAccessible(ctx context.Context, q ProfileReader, viewer, other int64) (bool, error) {
	var ok bool
	err := q.QueryRowContext(ctx, `SELECT ?1<>?2 AND `+dmBothActive+` AND (`+dmHasHistory+` OR `+dmFollowEither+`)`, viewer, other).Scan(&ok)
	return ok, err
}

// DirectDeliveryAllowed rechecks the delivery predicate for one queued dm.message
// frame. The sender's own sessions always receive the committed echo; a recipient
// session receives it while the sender may still message them, so every permitted
// message reaches an online recipient instantly.
func DirectDeliveryAllowed(ctx context.Context, q ProfileReader, viewer, sender, recipient int64) (bool, error) {
	switch viewer {
	case sender:
		return true, nil
	case recipient:
		return dmCanSend(ctx, q, sender, recipient)
	}
	return false, nil
}

func dmCursorEnsure(ctx context.Context, tx *sql.Tx, a, b int64) error {
	_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO dm_read_cursors(viewer_id,other_id,through_id) VALUES(?1,?2,0),(?2,?1,0)`, a, b)
	return err
}

func dmSelect() string {
	return `SELECT m.id,m.sender_id,m.recipient_id,` + sqlName("s") + `,m.body,m.image_path,m.created_at,m.client_id
 FROM private_messages m JOIN users s ON s.id=m.sender_id`
}

func sqlName(alias string) string {
	return "COALESCE(NULLIF(" + alias + ".nickname,'')," + alias + ".first_name||' '||" + alias + ".last_name)"
}

func scanDirectMessage(ctx context.Context, tx *sql.Tx, row interface{ Scan(...any) error }) (DirectMessage, error) {
	var m DirectMessage
	var image, client sql.NullString
	if err := row.Scan(&m.ID, &m.SenderID, &m.RecipientID, &m.SenderUsername, &m.Body, &image, &m.CreatedAt, &client); err != nil {
		return m, err
	}
	if client.Valid {
		m.ClientID = &client.String
	}
	var err error
	m.ImageURL, err = resourceMediaURLTx(ctx, tx, "message", m.ID, image)
	return m, err
}

// canonicalDirectImage returns the stored spelling of a private media reference.
func canonicalDirectImage(raw string) (string, bool) {
	if raw == "" {
		return "", true
	}
	id, ok := mediaID(raw)
	if !ok {
		return "", false
	}
	return MediaURL(id), true
}

// SendDirectMessage is the one send command shared by HTTP and the socket. The
// permission check, retry lookup, image claim, cursor initialization and insert
// share one serialized write transaction, so an unfollow either precedes the
// send (not found, nothing claimed) or follows it (the message stays stored).
func SendDirectMessage(ctx context.Context, database *sql.DB, req DirectSendRequest) (DirectSendResult, error) {
	if req.SenderID == req.RecipientID {
		return DirectSendResult{}, ErrNotFound
	}
	requested, ok := canonicalDirectImage(req.ImageURL)
	if !ok {
		return DirectSendResult{}, ErrInvalidInput
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return DirectSendResult{}, err
	}
	defer tx.Rollback()
	allowed, err := dmCanSend(ctx, tx, req.SenderID, req.RecipientID)
	if err != nil {
		return DirectSendResult{}, err
	}
	if !allowed {
		return DirectSendResult{}, ErrNotFound
	}
	// Permission precedes the retry lookup so a revoked relationship cannot
	// replay a stored result; the lookup precedes the image claim so a retry
	// never claims twice.
	var existing int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM private_messages WHERE sender_id=? AND client_id=?`, req.SenderID, req.ClientID).Scan(&existing)
	if err == nil {
		prior, err := scanDirectMessage(ctx, tx, tx.QueryRowContext(ctx, dmSelect()+` WHERE m.id=?`, existing))
		if err != nil {
			return DirectSendResult{}, err
		}
		stored := ""
		if prior.ImageURL != nil {
			stored = *prior.ImageURL
		}
		if prior.RecipientID != req.RecipientID || prior.Body != req.Body || stored != requested {
			return DirectSendResult{}, ErrMessageConflict
		}
		return DirectSendResult{Message: prior, Duplicate: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return DirectSendResult{}, err
	}
	var image *string
	if requested != "" {
		image = &requested
	}
	if err := claimMediaTx(ctx, tx, req.SenderID, "message", 0, image, req.RecipientID); err != nil {
		return DirectSendResult{}, err
	}
	if err := dmCursorEnsure(ctx, tx, req.SenderID, req.RecipientID); err != nil {
		return DirectSendResult{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO private_messages(sender_id,recipient_id,body,image_path,client_id) VALUES(?,?,?,?,?)`,
		req.SenderID, req.RecipientID, req.Body, image, req.ClientID)
	if err != nil {
		return DirectSendResult{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return DirectSendResult{}, err
	}
	if err := finishMediaClaimTx(ctx, tx, image); err != nil {
		return DirectSendResult{}, err
	}
	message, err := scanDirectMessage(ctx, tx, tx.QueryRowContext(ctx, dmSelect()+` WHERE m.id=?`, id))
	if err != nil {
		return DirectSendResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return DirectSendResult{}, err
	}
	return DirectSendResult{Message: message}, nil
}

// DirectHistory returns one snapshot page, ascending within the page. Participants
// keep history after the relationship ends; third parties and inactive accounts
// get ErrNotFound.
func DirectHistory(ctx context.Context, database *sql.DB, viewer, other, before int64, limit int) (DirectHistoryPage, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return DirectHistoryPage{}, err
	}
	defer tx.Rollback()
	allowed, err := DirectAccessible(ctx, tx, viewer, other)
	if err != nil {
		return DirectHistoryPage{}, err
	}
	if !allowed {
		return DirectHistoryPage{}, ErrNotFound
	}
	rows, err := tx.QueryContext(ctx, dmSelect()+` WHERE ((m.sender_id=?1 AND m.recipient_id=?2) OR (m.sender_id=?2 AND m.recipient_id=?1)) AND (?3=0 OR m.id<?3)
 ORDER BY m.id DESC LIMIT ?4`, viewer, other, before, limit+1)
	if err != nil {
		return DirectHistoryPage{}, err
	}
	type raw struct {
		message DirectMessage
		image   sql.NullString
		client  sql.NullString
	}
	pending := []raw{}
	for rows.Next() {
		var r raw
		m := &r.message
		if err := rows.Scan(&m.ID, &m.SenderID, &m.RecipientID, &m.SenderUsername, &m.Body, &r.image, &m.CreatedAt, &r.client); err != nil {
			rows.Close()
			return DirectHistoryPage{}, err
		}
		pending = append(pending, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return DirectHistoryPage{}, err
	}
	page := DirectHistoryPage{Messages: []DirectMessage{}}
	if len(pending) > limit {
		pending = pending[:limit]
		page.HasMore = true
	}
	for i := len(pending) - 1; i >= 0; i-- {
		m := pending[i].message
		if pending[i].client.Valid {
			value := pending[i].client.String
			m.ClientID = &value
		}
		m.ImageURL, err = resourceMediaURLTx(ctx, tx, "message", m.ID, pending[i].image)
		if err != nil {
			return DirectHistoryPage{}, err
		}
		page.Messages = append(page.Messages, m)
	}
	if page.HasMore {
		first := page.Messages[0].ID
		page.NextBeforeID = &first
	}
	return page, tx.Commit()
}

// DirectRoster lists existing conversations (by latest message) followed by
// messageable people with no history, all inside one snapshot.
func DirectRoster(ctx context.Context, database *sql.DB, viewer int64, page, per int) (DirectRosterPage, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return DirectRosterPage{}, err
	}
	defer tx.Rollback()
	var active bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`, viewer).Scan(&active); err != nil {
		return DirectRosterPage{}, err
	}
	if !active {
		return DirectRosterPage{}, ErrNotFound
	}
	const candidates = `WITH others AS (
  SELECT recipient_id AS o FROM private_messages WHERE sender_id=?1
  UNION SELECT sender_id FROM private_messages WHERE recipient_id=?1
  UNION SELECT followed_id FROM follows WHERE follower_id=?1 AND state='accepted'
  UNION SELECT follower_id FROM follows WHERE followed_id=?1 AND state='accepted'
 )`
	result := DirectRosterPage{Items: []DirectRosterEntry{}}
	if err := tx.QueryRowContext(ctx, candidates+` SELECT COUNT(*) FROM others JOIN users u ON u.id=others.o AND u.is_active=1 AND u.id<>?1`, viewer).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, candidates+`, latest AS (
  SELECT o,(SELECT MAX(id) FROM private_messages WHERE (sender_id=?1 AND recipient_id=o) OR (sender_id=o AND recipient_id=?1)) AS last_id FROM others
 )
 SELECT u.id,`+sqlName("u")+`,l.last_id,m.created_at,
  COALESCE(NULLIF(SUBSTR(m.body,1,?4),''),CASE WHEN m.image_path IS NOT NULL THEN '[image]' END,''),m.sender_id,
  EXISTS(SELECT 1 FROM follows f WHERE f.state='accepted' AND ((f.follower_id=?1 AND f.followed_id=u.id) OR (f.follower_id=u.id AND f.followed_id=?1))),
  COALESCE(c.through_id,0),
  (SELECT COUNT(*) FROM private_messages x WHERE x.sender_id=u.id AND x.recipient_id=?1 AND x.id>COALESCE(c.through_id,0)),
  u.profile_visibility='public' OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=?1 AND f.followed_id=u.id AND f.state='accepted')
 FROM latest l JOIN users u ON u.id=l.o AND u.is_active=1 AND u.id<>?1
 LEFT JOIN private_messages m ON m.id=l.last_id
 LEFT JOIN dm_read_cursors c ON c.viewer_id=?1 AND c.other_id=u.id
 ORDER BY l.last_id IS NULL,l.last_id DESC,u.display_name_search ASC,u.id ASC
 LIMIT ?2 OFFSET ?3`, viewer, per, (page-1)*per, rosterPreviewMaxChars)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var e DirectRosterEntry
		var lastID, sender sql.NullInt64
		var at, preview sql.NullString
		if err := rows.Scan(&e.UserID, &e.Username, &lastID, &at, &preview, &sender, &e.CanSend, &e.ReadThroughID, &e.UnreadCount, &e.PresenceVisible); err != nil {
			return result, err
		}
		if lastID.Valid {
			e.LastMessageAt, e.LastMessagePreview, e.LastSenderID = &at.String, &preview.String, &sender.Int64
		}
		result.Items = append(result.Items, e)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	rows.Close()
	return result, tx.Commit()
}

// DirectUnreadTotal counts incoming messages after each persisted cursor across
// every active conversation, independent of roster paging.
func DirectUnreadTotal(ctx context.Context, database *sql.DB, viewer int64) (int, error) {
	var total int
	err := database.QueryRowContext(ctx, `SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=?1 AND is_active=1) THEN (
 SELECT COUNT(*) FROM private_messages m JOIN users s ON s.id=m.sender_id AND s.is_active=1
 LEFT JOIN dm_read_cursors c ON c.viewer_id=m.recipient_id AND c.other_id=m.sender_id
 WHERE m.recipient_id=?1 AND m.id>COALESCE(c.through_id,0)) ELSE -1 END`, viewer).Scan(&total)
	if err == nil && total < 0 {
		return 0, ErrNotFound
	}
	return total, err
}

func directPairUnread(ctx context.Context, q ProfileReader, viewer, other int64) (int64, int, error) {
	var through int64
	var unread int
	err := q.QueryRowContext(ctx, `SELECT COALESCE(c.through_id,0),(SELECT COUNT(*) FROM private_messages x WHERE x.sender_id=?2 AND x.recipient_id=?1 AND x.id>COALESCE(c.through_id,0))
 FROM (SELECT 1) LEFT JOIN dm_read_cursors c ON c.viewer_id=?1 AND c.other_id=?2`, viewer, other).Scan(&through, &unread)
	return through, unread, err
}

// MarkDirectRead advances the viewer's persisted cursor monotonically. Zero is a
// no-op; a nonzero ID must be a message of this very pair.
func MarkDirectRead(ctx context.Context, database *sql.DB, viewer, other, through int64) (DirectReadResult, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return DirectReadResult{}, err
	}
	defer tx.Rollback()
	allowed, err := DirectAccessible(ctx, tx, viewer, other)
	if err != nil {
		return DirectReadResult{}, err
	}
	if !allowed {
		return DirectReadResult{}, ErrNotFound
	}
	if err := dmCursorEnsure(ctx, tx, viewer, other); err != nil {
		return DirectReadResult{}, err
	}
	current, _, err := directPairUnread(ctx, tx, viewer, other)
	if err != nil {
		return DirectReadResult{}, err
	}
	if through > 0 {
		var belongs bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM private_messages WHERE id=?3 AND ((sender_id=?1 AND recipient_id=?2) OR (sender_id=?2 AND recipient_id=?1)))`, viewer, other, through).Scan(&belongs); err != nil {
			return DirectReadResult{}, err
		}
		if !belongs {
			return DirectReadResult{}, contentField("through_id", "INVALID_ID")
		}
	}
	result := DirectReadResult{ThroughID: current}
	if through > current {
		if _, err := tx.ExecContext(ctx, `UPDATE dm_read_cursors SET through_id=? WHERE viewer_id=? AND other_id=? AND through_id<?`, through, viewer, other, through); err != nil {
			return DirectReadResult{}, err
		}
		result.ThroughID, result.Changed = through, true
	}
	if _, result.UnreadCount, err = directPairUnread(ctx, tx, viewer, other); err != nil {
		return DirectReadResult{}, err
	}
	return result, tx.Commit()
}
