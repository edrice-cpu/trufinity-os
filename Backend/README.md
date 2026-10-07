# TruFinity Backend Foundation

This is the foundational Node.js + TypeScript backend for the TruFinity Plumbing Heating & Cooling – BI & Dashboard System.

## Prerequisites
- Node.js (v18+ recommended)
- Docker Desktop (for local PostgreSQL database)

## Local Setup Instructions

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Environment Variables**
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

3. **Start Local Database**
   This project uses a `docker-compose.yml` to spin up PostgreSQL easily.
   ```bash
   docker-compose up -d
   ```

4. **Run Migrations**
   Initialize the database schema:
   ```bash
   npm run migrate:latest
   ```

5. **Start Development Server**
   ```bash
   npm run dev
   ```

The server will start on port `3000`. You can test it by calling:
`http://localhost:3000/health`

## Scripts
- `npm run dev` - Start dev server with hot-reload
- `npm run build` - Compile TypeScript to JavaScript
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run format` - Run Prettier formatting
- `npm test` - Run Jest tests
- `npm run migrate:make <name>` - Create a new migration file
- `npm run migrate:latest` - Run pending migrations
- `npm run migrate:rollback` - Rollback last migration batch

## Documentation
Please refer to `TruFinity_BACKEND_PROJECT_CONTEXT.md` for complete architectural context, decisions, and future plans.
