import os
import sys
from google import genai
from google.genai import types

# Add the project root to sys.path so we can run this file directly
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from backend.prompts.system_prompts import AGENT_SYSTEM_PROMPT
from backend.tools.time_tool import get_current_time
from backend.tools.database_tool import query_custom_database

def chat_with_agent(user_message: str, api_key: str) -> str:
    """Sends a message to the Gemini Agent and handles tool execution."""
    if not api_key:
        return "Error: Gemini API Key is missing. Please configure it in the admin dashboard."

    try:
        client = genai.Client(api_key=api_key)
        
        # Tools the agent is allowed to use
        agent_tools = [get_current_time, query_custom_database]
        
        # We can use the chat interface for a conversational agent
        chat = client.chats.create(
            model="gemini-2.5-flash",
            config=types.GenerateContentConfig(
                system_instruction=AGENT_SYSTEM_PROMPT,
                tools=agent_tools,
                temperature=0.7,
            )
        )
        
        # Send the message
        response = chat.send_message(user_message)
        
        # The genai SDK automatically handles executing the function and sending the result back to the model 
        # when using chat.send_message if the tools are provided.
        # So we just return the final text.
        return response.text

    except Exception as e:
        return f"Agent Error: {str(e)}"

if __name__ == "__main__":
    # Test script: Provide your Gemini API key here or read from config to test locally
    from backend.server import read_json, CONFIG_PATH
    
    print("Fetching Gemini Key from Config...")
    config = read_json(CONFIG_PATH, {})
    test_key = config.get("geminiKey")
    
    if test_key:
        print("Key found! Chatting with Agent (Type 'exit' to quit):")
        while True:
            msg = input("You: ")
            if msg.lower() in ['exit', 'quit']:
                break
            print(f"Agent: {chat_with_agent(msg, test_key)}")
    else:
        print("No Gemini API key found in config.json. Please configure it in the dashboard first.")
