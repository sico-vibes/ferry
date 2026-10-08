import unittest
from stats import median
class MedianTest(unittest.TestCase):
    def test_odd(self):
        self.assertEqual(median([7, 1, 3]), 3)
    def test_even(self):
        self.assertEqual(median([8, 2, 4, 6]), 5)
    def test_empty(self):
        with self.assertRaises(ValueError): median([])
    def test_no_mutation(self):
        values = [4, 1, 2]
        median(values)
        self.assertEqual(values, [4, 1, 2])
if __name__ == '__main__': unittest.main()
