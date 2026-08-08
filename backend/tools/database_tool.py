import os
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CUSTOM_DB_PATH = os.path.join(BASE_DIR, 'database', 'custom_database.json')

def query_custom_database(query: str) -> str:
    """Queries the custom database for a specific keyword or phrase and returns the answer."""
    try:
        with open(CUSTOM_DB_PATH, 'r', encoding='utf-8') as f:
            db_content = json.load(f)
            
        # simple lowercase matching
        query_lower = query.lower()
        for key, value in db_content.items():
            if query_lower in key.lower() or key.lower() in query_lower:
                return value
                
        return "I could not find an answer to that in the custom database."
    except Exception as e:
        return f"Error reading database: {str(e)}"
