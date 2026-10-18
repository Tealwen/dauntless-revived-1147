CREATE INDEX `characters_user` ON `characters` (`userId`);--> statement-breakpoint
CREATE TABLE `trackedobjectives1147` (
	`accountId` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`updatedDate` text NOT NULL
);
