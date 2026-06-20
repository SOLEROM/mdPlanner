import os
import sys

# Make server.py / mdmarks.py importable when pytest runs from anywhere.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
