// cmd/backend/server.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"forum/internal/db"
	"forum/internal/env"
	"forum/internal/router"
	"forum/internal/ws"
)

func Start() {
	/* ----------------------------
	   Load environment variables
	-----------------------------*/
	env.LoadEnv(".env")

	/* ------------------------------------
	   Resolve DB path (local & Docker)
	-------------------------------------*/
	dbPath := databasePath()

	/* ----------------------------
	   Initialize database
	-----------------------------*/
	database, err := db.InitDB(context.Background(), dbPath)
	if err != nil {
		log.Fatal("DATABASE INIT ERROR:", err)
	}
	defer database.Close()

	log.Println("Database initialized")

	/* ----------------------------
	   Background session cleanup
	-----------------------------*/
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()

		for range ticker.C {
			if err := db.CleanupSessions(context.Background(), database); err != nil {
				log.Println("Session cleanup error:", err)
			}
		}
	}()

	/* ----------------------------
	   WebSocket Hub
	-----------------------------*/
	hub := ws.NewHub()

	// Push notifications down the socket the client already has open, so the
	// SPA does not have to poll GET /notifications every few seconds to find
	// out that nothing has happened.
	db.SetNotificationHook(hub.NotifyNotification)
	db.SetSocialInvalidationHook(hub.InvalidateSocial)

	/* ----------------------------
	   HTTP server
	-----------------------------*/
	handler := router.NewRouter(database, hub)

	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Println("Backend listening on " + addr)

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal("SERVER ERROR:", err)
	}
}

// databasePath is DB_PATH, or the local development database.
func databasePath() string {
	if path := os.Getenv("DB_PATH"); path != "" {
		return path
	}
	return "./data/forum.db"
}

// SeedQA resets the configured database to the QA sample data, so a running
// container can be filled with `server -seed-qa` (see `make stack-seed`).
func SeedQA() {
	env.LoadEnv(".env")
	dbPath := databasePath()
	database, err := db.InitDB(context.Background(), dbPath)
	if err != nil {
		log.Fatal("DATABASE INIT ERROR:", err)
	}
	defer database.Close()
	if err := db.ApplyQASeeds(context.Background(), database); err != nil {
		log.Fatal("QA SEED ERROR:", err)
	}
	log.Printf("QA seeds applied to %s", dbPath)
}
