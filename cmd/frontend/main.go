// cmd/frontend/main.go
package main

import (
	"forum/cmd/frontend/config"
	"log"
	"net/http"
)

func main() {

	if err := config.ValidateFrontendStartup(); err != nil {
		log.Fatal(err)
	}

	mux := NewMux()

	log.Println("Frontend running at http://localhost:3000")
	log.Fatal(http.ListenAndServe(":3000", mux))
}
