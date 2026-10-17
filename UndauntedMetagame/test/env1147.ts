// Import before src/routes/store.ts in a test process that needs the 1.14.7 offer shape: that module reads
// TARGET_GAME_VERSION once, when it loads (each test file runs in its own process).
process.env.TARGET_GAME_VERSION = "1.14.7";
