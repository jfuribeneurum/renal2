from database import create_backup, initialize


if __name__ == "__main__":
    initialize()
    path = create_backup("programado")
    print(path)
