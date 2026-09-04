FROM python:3.12-alpine

WORKDIR /app
COPY . /app
RUN cp /app/EM_Facility_final.html /app/index.html

ENV PORT=10000
EXPOSE 10000

CMD ["sh", "-c", "python -m http.server \"${PORT}\" --directory /app"]
