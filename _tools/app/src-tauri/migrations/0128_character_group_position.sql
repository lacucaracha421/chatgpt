-- A person's order of the character groups inside one series. NULL means "not placed yet":
-- groups of a series nobody has reordered keep their name order, and a group created later in
-- an ordered series is listed after the placed ones. A reorder writes 1..n for every group of
-- the series in one transaction; the existing `mobile_character_groups_update` trigger marks
-- the character publication dirty, so the tablet receives the order.
ALTER TABLE character_groups ADD COLUMN position INTEGER;

PRAGMA user_version = 128;
