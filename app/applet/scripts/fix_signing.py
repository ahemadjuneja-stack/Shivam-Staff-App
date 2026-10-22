import os
import base64

def main():
    b64_path = "keystore.b64"
    keystore_path = "android/app/shivam.keystore"
    
    if os.path.exists(b64_path):
        with open(b64_path, "rb") as f:
            b64_data = f.read()
        key_bytes = base64.b64decode(b64_data)
        os.makedirs(os.path.dirname(keystore_path), exist_ok=True)
        with open(keystore_path, "wb") as f:
            f.write(key_bytes)
        print("Successfully decoded keystore.b64 to", keystore_path)
    else:
        print("keystore.b64 not found, skipping keystore decode.")

if __name__ == "__main__":
    main()
