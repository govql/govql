ALTER TABLE votes
  ADD COLUMN nomination_number TEXT;

ALTER TABLE votes
  ADD COLUMN nomination_title TEXT;

COMMENT ON COLUMN votes.nomination_number IS 'Nomination identifier exactly as supplied by unitedstates/congress. Group related votes by (congress, nomination_number); multiple votes may reference the same nomination. NULL when absent from the source.';

COMMENT ON COLUMN votes.nomination_title IS 'Nomination title supplied by unitedstates/congress. NULL when absent from the source.';
