"""Do not materialize the complete historical prediction payload table."""
import unittest
from holdout_dataset import build_dataset
from test_character_holdout import add, database


class LoadingTests(unittest.TestCase):
    def test_payload_reads_are_scoped_to_selected_evidence(self):
        connection = database()
        self.addCleanup(connection.close)
        add(connection, "one")
        statements = []
        connection.set_trace_callback(statements.append)
        build_dataset(connection, "2026-09-12T00:00:00Z")
        reads = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT")
                 and "result_json" in sql]
        self.assertTrue(reads)
        self.assertTrue(all("WHERE evidence_id=" in sql for sql in reads), reads)


if __name__ == "__main__":
    unittest.main()
