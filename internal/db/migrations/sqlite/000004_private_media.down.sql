-- Private media references and file copies cannot safely be downgraded by SQL.
-- Restore a coordinated DB/media/source backup with the matching runtime.
CREATE TABLE media_downgrade_requires_backup(valid INTEGER CHECK(valid=1));
INSERT INTO media_downgrade_requires_backup VALUES(0);
