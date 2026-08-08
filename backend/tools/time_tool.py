from datetime import datetime

def get_current_time() -> str:
    """Returns the current date and time."""
    now = datetime.now()
    return now.strftime("%Y-%m-%d %H:%M:%S")
