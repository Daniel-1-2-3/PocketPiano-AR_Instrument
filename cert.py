from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509 import IPAddress
import ipaddress, datetime

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

cert = (
    x509.CertificateBuilder()
    .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "172.20.10.4")]))
    .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "172.20.10.4")]))
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(datetime.datetime.utcnow())
    .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=30))
    .add_extension(x509.SubjectAlternativeName([IPAddress(ipaddress.IPv4Address("172.20.10.4"))]), critical=False)
    .sign(key, hashes.SHA256())
)

open("key.pem","wb").write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
open("cert.pem","wb").write(cert.public_bytes(serialization.Encoding.PEM))
print("done")