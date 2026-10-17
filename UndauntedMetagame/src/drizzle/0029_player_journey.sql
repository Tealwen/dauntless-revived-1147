CREATE TABLE `playerjourney` (
	`journeyKey` text PRIMARY KEY NOT NULL,
	`nodes` text NOT NULL,
	`updateVersion` integer NOT NULL,
	`updatedDate` text NOT NULL
);
