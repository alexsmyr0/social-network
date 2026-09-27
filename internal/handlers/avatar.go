package handlers

import (
	"bytes"
	"database/sql"
	"errors"
	"image"
	"image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"forum/internal/db"
	"forum/internal/middleware"
	"github.com/google/uuid"
)

const avatarMaxBytes = 5 << 20

func invalidAvatar() *APIError {
	err := NewError("INVALID_AVATAR", "invalid avatar", http.StatusUnprocessableEntity)
	err.Fields = map[string]string{"avatar": "INVALID_AVATAR"}
	return err
}

func readAvatar(file *multipart.FileHeader) ([]byte, string, *APIError) {
	if file.Size > avatarMaxBytes {
		return nil, "", NewError("PAYLOAD_TOO_LARGE", "avatar is too large", http.StatusRequestEntityTooLarge)
	}
	f, err := file.Open()
	if err != nil {
		return nil, "", invalidAvatar()
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, avatarMaxBytes+1))
	if err != nil {
		return nil, "", invalidAvatar()
	}
	if len(data) > avatarMaxBytes {
		return nil, "", NewError("PAYLOAD_TOO_LARGE", "avatar is too large", http.StatusRequestEntityTooLarge)
	}
	if len(data) == 0 {
		return nil, "", invalidAvatar()
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 {
		return nil, "", invalidAvatar()
	}
	types := map[string]string{"jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif"}
	mimeType, ok := types[format]
	if !ok {
		return nil, "", invalidAvatar()
	}
	declared := file.Header.Get("Content-Type")
	if declared != "" && declared != "application/octet-stream" && declared != mimeType {
		return nil, "", invalidAvatar()
	}
	extension := strings.ToLower(filepath.Ext(file.Filename))
	known := map[string]string{".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".gif": "gif"}
	if expected, recognized := known[extension]; recognized && expected != format {
		return nil, "", invalidAvatar()
	}
	if format == "gif" {
		if !gifBudgetOK(data, config.Width, config.Height) {
			return nil, "", invalidAvatar()
		}
		if _, err := gif.DecodeAll(bytes.NewReader(data)); err != nil {
			return nil, "", invalidAvatar()
		}
	} else if _, decodedFormat, err := image.Decode(bytes.NewReader(data)); err != nil || decodedFormat != format {
		return nil, "", invalidAvatar()
	}
	return data, mimeType, nil
}

// Count GIF frames before decoding to cap cumulative canvas allocation/work.
func gifBudgetOK(data []byte, width, height int) bool {
	if len(data) < 13 || !bytes.HasPrefix(data, []byte("GIF8")) {
		return false
	}
	i := 13
	if data[10]&0x80 != 0 {
		i += 3 * (1 << (1 + uint(data[10]&7)))
	}
	frames := 0
	for i < len(data) {
		switch data[i] {
		case 0x3b:
			return frames > 0 && i == len(data)-1
		case 0x21:
			i += 2
			if i >= len(data) {
				return false
			}
			for {
				if i >= len(data) {
					return false
				}
				n := int(data[i])
				i++
				if n == 0 {
					break
				}
				i += n
				if i > len(data) {
					return false
				}
			}
		case 0x2c:
			if i+10 > len(data) {
				return false
			}
			frames++
			if frames > 100 || uint64(frames)*uint64(width)*uint64(height) > 64_000_000 {
				return false
			}
			packed := data[i+9]
			i += 10
			if packed&0x80 != 0 {
				i += 3 * (1 << (1 + uint(packed&7)))
			}
			if i >= len(data) {
				return false
			}
			i++ // LZW code size
			for {
				if i >= len(data) {
					return false
				}
				n := int(data[i])
				i++
				if n == 0 {
					break
				}
				i += n
				if i > len(data) {
					return false
				}
			}
		default:
			return false
		}
	}
	return false
}

func storeAvatar(root string, data []byte, mimeType string) (string, error) {
	tmp, err := os.CreateTemp(root, ".tmp-")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	ext := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif"}[mimeType]
	key := uuid.NewString() + ext
	if err := os.Rename(tmp.Name(), filepath.Join(root, "objects", key)); err != nil {
		return "", err
	}
	dir, err := os.Open(filepath.Join(root, "objects"))
	if err != nil {
		os.Remove(filepath.Join(root, "objects", key))
		return "", err
	}
	err = dir.Sync()
	dir.Close()
	if err != nil {
		os.Remove(filepath.Join(root, "objects", key))
		return "", err
	}
	return key, nil
}

func (u *UsersHandler) avatar(w http.ResponseWriter, r *http.Request, userID int64) {
	ownerID, err := middleware.GetUserID(r.Context())
	if err != nil || ownerID != userID {
		notFound(w, r)
		return
	}
	key, err := db.AvatarKey(r.Context(), u.conn, userID)
	if errors.Is(err, sql.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		writeHandlerError(w, r, err, "failed to load avatar")
		return
	}
	if filepath.Base(key) != key {
		writeHandlerError(w, r, errors.New("invalid avatar key"), "failed to load avatar")
		return
	}
	root, err := db.AvatarRoot(u.conn)
	if err != nil {
		writeHandlerError(w, r, err, "failed to load avatar")
		return
	}
	data, err := os.ReadFile(filepath.Join(root, "objects", key))
	if err != nil {
		writeHandlerError(w, r, err, "failed to load avatar")
		return
	}
	mimeType := map[string]string{".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif"}[filepath.Ext(key)]
	if mimeType == "" {
		writeHandlerError(w, r, errors.New("invalid avatar type"), "failed to load avatar")
		return
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
