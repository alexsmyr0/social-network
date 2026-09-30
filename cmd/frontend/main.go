// cmd/frontend/main.go
package main

import (
	"forum/cmd/frontend/config"
	"log"
	"net/http"
	"os"
)

func main() {

	if err := config.ValidateFrontendStartup(); err != nil {
		log.Fatal(err)
	}

	mux := NewMux()

	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":3000"
	}
	log.Println("Frontend listening on " + addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
