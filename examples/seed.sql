CREATE TABLE authors (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  born       date,
  created_at timestamp,
  updated_at timestamptz,
  royalties  numeric(12,2),
  views      bigint,
  avatar     bytea,
  bio        text
);
CREATE TABLE books (
  id        serial PRIMARY KEY,
  author_id int NOT NULL REFERENCES authors(id),
  title     text NOT NULL,
  published date
);
CREATE TABLE chapters (
  book_id    int NOT NULL REFERENCES books(id),
  chapter_no int NOT NULL,
  heading    text,
  PRIMARY KEY (book_id, chapter_no)
);
CREATE TABLE audit_log (
  action text,
  at     timestamptz
);
INSERT INTO authors (name, born, created_at, updated_at, royalties, views, avatar, bio) VALUES
  ('Ursula Le Guin', '1929-10-21', '2024-01-01 09:30:00', '2024-01-01 09:30:00+00', 1234.56, 9007199254740993, '\xdeadbeef', NULL),
  ('Italo Calvino',  '1923-10-15', '2024-02-02 11:00:00', '2024-02-02 11:00:00+00',   99.00, 42, NULL, 'Cosmicomics');
INSERT INTO books (author_id, title, published) VALUES
  (1, 'The Dispossessed', '1974-01-01'),
  (1, 'A Wizard of Earthsea', '1968-01-01'),
  (2, 'Invisible Cities', '1972-01-01');
INSERT INTO chapters (book_id, chapter_no, heading) VALUES
  (1, 1, 'Shevek'), (1, 2, 'Anarres'), (3, 1, 'Cities & Memory');
INSERT INTO audit_log (action, at) VALUES
  ('login', '2024-03-01 00:00:00+00'),
  ('login', '2024-03-01 00:00:00+00');
