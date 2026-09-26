package main

import (
	"context"
	"flag"
	"log"
	"os"
	"path/filepath"
	"strings"

	"forum/internal/db"
	"forum/internal/env"
)

func main() {
	env.LoadEnv(".env")

	dbPathFlag := flag.String("db-path", "", "path to the SQLite database")
	flag.Parse()

	dbPath := strings.TrimSpace(*dbPathFlag)
	if dbPath == "" {
		dbPath = strings.TrimSpace(os.Getenv("DB_PATH"))
	}
	if dbPath == "" {
		dbPath = "./data/social-network.db"
	}

	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		log.Fatalf("create database directory: %v", err)
	}

	ctx := context.Background()

	database, err := db.InitDB(ctx, dbPath)
	if err != nil {
		log.Fatalf("initialize database: %v", err)
	}
	defer database.Close()

	if err := db.ApplyQASeeds(ctx, database); err != nil {
		log.Fatalf("apply QA seeds: %v", err)
	}

	log.Printf("QA seeds applied to %s", dbPath)
}
