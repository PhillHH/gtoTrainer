# Kurzform der vier Root-Scripts aus package.json.
# Voraussetzung: Node-Version aus .nvmrc (nvm use) und pnpm via corepack.

.PHONY: dev build lint test install help

help:
	@echo "Verfuegbare Targets: install, dev, build, lint, test"

install:
	pnpm install

dev:
	pnpm dev

build:
	pnpm build

lint:
	pnpm lint

test:
	pnpm test
