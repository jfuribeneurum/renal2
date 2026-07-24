FROM python:3.10-slim

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Set environment variables for Render
ENV RENAL_HOST=0.0.0.0
ENV PORT=8780
ENV PYTHONUNBUFFERED=1
ENV RENAL_ADMIN_EMAIL=admin@neurum.local
ENV RENAL_ADMIN_PASSWORD=Admin12345!

# Expose the port
EXPOSE 8780

# Run the application
CMD ["python", "run.py"]
