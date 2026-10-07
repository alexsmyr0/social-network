-- Audience/optional-title removal is lossy. Restore a coordinated backup instead.
CREATE TEMP TABLE b15_refuse_down(value INTEGER CHECK(value=1));
INSERT INTO b15_refuse_down VALUES(0);
