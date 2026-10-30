package main

import "flag"

func main() {
	seedQA := flag.Bool("seed-qa", false, "reset the database to the QA sample data and exit")
	flag.Parse()
	if *seedQA {
		SeedQA()
		return
	}
	Start()
}
