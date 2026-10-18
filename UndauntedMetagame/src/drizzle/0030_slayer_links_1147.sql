CREATE TABLE `slayerlinkstate1147` (
	`linkId` text PRIMARY KEY NOT NULL,
	`prizePool` text,
	`poolSource` text,
	`senderClaimedAt` integer,
	`targetClaimedAt` integer,
	`senderRewards` text,
	`targetRewards` text,
	`senderRemovedAt` integer,
	`targetRemovedAt` integer
);
